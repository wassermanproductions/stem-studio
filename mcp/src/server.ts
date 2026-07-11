/**
 * The stem-studio MCP server: registers the six pipeline tools on an McpServer
 * and wires long-running work through the JobRegistry. Transport-agnostic — the
 * bin entry (index.ts) connects it over stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import packageJson from '../package.json' with { type: 'json' }

import { probe } from './ffmpeg.js'
import { startSeparation } from './pipeline.js'
import { setupStatus, startSetup } from './setup.js'
import { JobRegistry, type JobSnapshot } from './jobs.js'
import type { PipelineStage, SeparationOutputs } from './types.js'

const VERSION = packageJson.version

/** Rough stage weights so a single 0..100 percent can be reported to clients. */
const STAGE_BASE: Record<PipelineStage, number> = {
  extracting: 0,
  setup: 0,
  loading: 10,
  separating: 20,
  polishing: 80,
  writing: 85,
  remuxing: 95,
  done: 100
}
const STAGE_SPAN: Record<PipelineStage, number> = {
  extracting: 10,
  setup: 10,
  loading: 10,
  separating: 60,
  polishing: 5,
  writing: 10,
  remuxing: 5,
  done: 0
}

/** Fold a stage + within-stage percent into an overall 0..100. */
function overallPercent(stage: PipelineStage, pct: number): number {
  const base = STAGE_BASE[stage] ?? 0
  const span = STAGE_SPAN[stage] ?? 0
  const within = pct < 0 ? 0 : Math.min(100, pct)
  return Math.min(100, Math.round(base + (within / 100) * span))
}

/** JSON tool result helper. */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}
function fail(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true
  }
}

export function createServer(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): McpServer {
  const server = new McpServer({ name: 'stem-studio', version: VERSION })
  const jobs = new JobRegistry()
  const testEnginesEnabled = platform !== 'win32'
    ? env.STEMSTUDIO_ENABLE_TEST_ENGINES !== '0'
    : env.STEMSTUDIO_ENABLE_TEST_ENGINES === '1'
  const unlicensedEnginesEnabled = platform !== 'win32'
    ? env.STEMSTUDIO_ENABLE_UNLICENSED_ENGINES !== '0'
    : env.STEMSTUDIO_RESEARCH_BUILD === '1' &&
      env.STEMSTUDIO_ENABLE_UNLICENSED_ENGINES === '1'
  const engineSchema = unlicensedEnginesEnabled
    ? testEnginesEnabled
      ? z.enum(['tiger', 'mvsep', 'stub'])
      : z.enum(['tiger', 'mvsep'])
    : testEnginesEnabled
      ? z.enum(['tiger', 'stub'])
      : z.literal('tiger')
  const qualitySchema = unlicensedEnginesEnabled
    ? z.enum(['fast', 'high', 'max'])
    : z.enum(['fast', 'high'])

  /**
   * Send a notifications/progress message if the caller supplied a
   * progressToken (per the MCP progress convention). No-op otherwise.
   */
  type Extra = {
    sendNotification: (n: unknown) => Promise<void>
    _meta?: { progressToken?: string | number }
  }
  const notifyProgress = (
    extra: Extra,
    progress: number,
    message: string
  ): void => {
    const token = extra._meta?.progressToken
    if (token === undefined) return
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total: 100, message }
      })
      .catch(() => {})
  }

  /* ------------------------------ probe_media ---------------------------- */
  server.registerTool(
    'probe_media',
    {
      title: 'Probe a media file',
      description:
        'Inspect a local audio or video file and return its duration (seconds), ' +
        'sampleRate, channels, has_video flag, and format (container / codec). ' +
        'Input must be a LOCAL FILE PATH (not a URL or stream). Fast (<1s). ' +
        'Errors clearly if the file is missing, has no audio, or ffprobe is not ' +
        'installed. Call this first to decide whether multitrack_video applies.',
      inputSchema: {
        path: z.string().describe('Absolute path to a local audio/video file.')
      }
    },
    async ({ path }) => {
      try {
        const r = await probe(path)
        return ok({
          path: r.path,
          name: r.name,
          format: r.format,
          duration: r.duration,
          sample_rate: r.sampleRate,
          channels: r.channels,
          has_video: r.hasVideo,
          ext: r.ext
        })
      } catch (e) {
        return fail((e as Error).message)
      }
    }
  )

  /* ---------------------------- separate_stems --------------------------- */
  server.registerTool(
    'separate_stems',
    {
      title: 'Separate a soundtrack into stems',
      description:
        'Separate a married soundtrack (video or audio) into Dialogue, Music, and ' +
        'SFX stems, delivering 48 kHz/24-bit WAVs named <basename>_DIALOGUE/_MUSIC/' +
        '_SFX.wav plus <basename>_MARRIED.wav (the conformed original mix). For video ' +
        'inputs, multitrack_video:true also remuxes a <basename>_STEMS.mov with the 3 ' +
        'stems as labelled audio tracks. input_path must be a LOCAL FILE PATH. ' +
        'RUNTIME: minutes — TIGER on an accelerator is roughly real-time-ish, ' +
        'and much slower on CPU; quality "high" takes longer. ' +
        'With wait:true (default) the call blocks to completion and emits progress ' +
        'notifications — use a generous client timeout. With wait:false it returns a ' +
        'job_id immediately; poll check_job. Requires a ready Python env (see ' +
        'setup_status). Never streams audio through the protocol — paths only.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the local input file.'),
        output_dir: z
          .string()
          .optional()
          .describe('Directory for the output WAVs/.mov. Default: alongside the input.'),
        quality: qualitySchema
          .optional()
          .describe(
            unlicensedEnginesEnabled
              ? 'fast (default), high (TTA ensemble), or legacy max (dual-engine blend).'
              : 'fast (default) or high (TTA ensemble).'
          ),
        engine: engineSchema
          .optional()
          .describe(
            unlicensedEnginesEnabled
              ? testEnginesEnabled
                ? 'Engine: tiger, mvsep, or the test-only stub enabled by the CI harness.'
                : 'Engine: tiger or legacy mvsep.'
              : testEnginesEnabled
                ? 'Engine: tiger, or the test-only stub enabled by the CI harness.'
                : 'Licensed Windows production engine: tiger.'
          ),
        multitrack_video: z
          .boolean()
          .optional()
          .describe('Video inputs only: also produce a multitrack _STEMS.mov. Default false.'),
        polish_dialogue: z
          .boolean()
          .optional()
          .describe(
            'Optional post-separation pass that reduces residual music/effects ' +
              'bleed in the dialogue stem (the removed bleed is folded into effects, ' +
              'so the stems still sum to the input). Slower. Default false.'
          ),
        wait: z
          .boolean()
          .optional()
          .describe('Block until done (default true). false returns a job_id to poll with check_job.')
      }
    },
    async (input, extra) => {
      const wait = input.wait ?? true
      const job = jobs.create('separate')

      const handle = startSeparation(
        {
          inputPath: input.input_path,
          outputDir: input.output_dir,
          quality: input.quality,
          engine: input.engine,
          multitrackVideo: input.multitrack_video,
          polishDialogue: input.polish_dialogue
        },
        {
          onStage: (stage, pct, detail) => {
            jobs.update(job.jobId, { stage, percent: pct, detail })
            if (wait) {
              notifyProgress(
                extra as unknown as Extra,
                overallPercent(stage, pct),
                detail ? `${stage}: ${detail}` : stage
              )
            }
          }
        },
        env
      )
      jobs.setCancel(job.jobId, handle.cancel)

      const finalize = handle.result.then(
        (out: SeparationOutputs) => {
          jobs.finish(job.jobId, deliveryPayload(out))
          return out
        },
        (err: unknown) => {
          const msg = (err as Error).message ?? String(err)
          if (msg === 'Cancelled') void jobs.cancel(job.jobId)
          else jobs.fail(job.jobId, msg)
          throw err
        }
      )

      if (!wait) {
        // Prevent an unhandled rejection; status is tracked on the job.
        finalize.catch(() => {})
        return ok({
          job_id: job.jobId,
          status: 'running',
          message: 'Separation started. Poll check_job with this job_id.'
        })
      }

      try {
        const out = await finalize
        return ok({ job_id: job.jobId, status: 'done', ...deliveryPayload(out) })
      } catch (e) {
        const snap = jobs.snapshot(job.jobId)
        return fail(
          `${(e as Error).message}` +
            (snap ? ` (job ${job.jobId}, status ${snap.status})` : '')
        )
      }
    }
  )

  /* ------------------------------- check_job ----------------------------- */
  server.registerTool(
    'check_job',
    {
      title: 'Check a background job',
      description:
        'Return the status (running/done/error/cancelled), current stage, and ' +
        'percent for a job started with wait:false (separate_stems or ' +
        'setup_environment). On done, includes the output file paths (separation) ' +
        'or python path (setup). Poll every few seconds for long jobs.',
      inputSchema: {
        job_id: z.string().describe('The job_id returned by a wait:false call.')
      }
    },
    async ({ job_id }) => {
      const snap = jobs.snapshot(job_id)
      if (!snap) return fail(`Unknown job_id: ${job_id}`)
      return ok(publicJob(snap))
    }
  )

  /* ------------------------------ cancel_job ----------------------------- */
  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a background job',
      description:
        'Kill a running job\'s process tree and clean up its temp files. ' +
        'Returns the resulting status. No-op (returns the existing terminal ' +
        'status) if the job already finished.',
      inputSchema: {
        job_id: z.string().describe('The job_id to cancel.')
      }
    },
    async ({ job_id }) => {
      const status = await jobs.cancel(job_id)
      if (status === null) return fail(`Unknown job_id: ${job_id}`)
      return ok({ job_id, status })
    }
  )

  /* ----------------------------- setup_status ---------------------------- */
  server.registerTool(
    'setup_status',
    {
      title: 'Check Python environment readiness',
      description:
        'Report whether the Python worker environment is ready: venv python ' +
        'presence, whether torch/numpy/soundfile import, the compute device ' +
        '(from the worker --probe if available, else inline torch detection), and ' +
        'model-cache presence. Fast. Call before separate_stems; if not ready, run ' +
        'setup_environment. Installed builds share the app\'s private runtime and model cache.',
      inputSchema: {}
    },
    async () => {
      const s = await setupStatus(env)
      return ok(s)
    }
  )

  /* --------------------------- setup_environment ------------------------- */
  server.registerTool(
    'setup_environment',
    {
      title: 'Create the Python environment',
      description:
        'Create the private worker environment. Windows uses bundled uv, pinned ' +
        'CPython 3.12.10, and a hashed dependency lock; macOS/Linux use python3. PyTorch is ' +
        'a large download — RUNTIME is typically several minutes on first run. With ' +
        'wait:true (default) blocks and emits progress notifications; with ' +
        'wait:false returns a job_id to poll via check_job. Idempotent-ish: reuses ' +
        'an existing venv dir and just (re)installs. Run setup_status afterwards to ' +
        'confirm readiness.',
      inputSchema: {
        wait: z
          .boolean()
          .optional()
          .describe('Block until done (default true). false returns a job_id to poll.')
      }
    },
    async (input, extra) => {
      const wait = input.wait ?? true
      const job = jobs.create('setup')

      const handle = startSetup(env, {
        onProgress: (detail) => {
          jobs.update(job.jobId, { stage: 'setup', percent: -1, detail })
          if (wait) notifyProgress(extra as unknown as Extra, 0, detail)
        }
      })
      jobs.setCancel(job.jobId, handle.cancel)

      const finalize = handle.result.then(
        (res) => {
          jobs.finish(job.jobId, { python_path: res.pythonPath })
          return res
        },
        (err: unknown) => {
          const msg = (err as Error).message ?? String(err)
          if (msg === 'Cancelled') void jobs.cancel(job.jobId)
          else jobs.fail(job.jobId, msg)
          throw err
        }
      )

      if (!wait) {
        finalize.catch(() => {})
        return ok({
          job_id: job.jobId,
          status: 'running',
          message: 'Setup started. Poll check_job with this job_id.'
        })
      }

      try {
        const res = await finalize
        return ok({ job_id: job.jobId, status: 'done', python_path: res.pythonPath })
      } catch (e) {
        return fail(`${(e as Error).message} (job ${job.jobId})`)
      }
    }
  )

  return server
}

/** Shape the terminal separation result for tool output / check_job. */
function deliveryPayload(out: SeparationOutputs) {
  return {
    output_dir: out.outputDir,
    stems: out.stems,
    married: out.married,
    multitrack_video: out.multitrackVideo ?? null
  }
}

/** Public, snake-cased view of a job snapshot for check_job. */
function publicJob(snap: JobSnapshot) {
  return {
    job_id: snap.jobId,
    kind: snap.kind,
    status: snap.status,
    stage: snap.stage ?? null,
    percent: snap.percent,
    detail: snap.detail ?? null,
    result: snap.status === 'done' ? snap.result : null,
    error: snap.status === 'error' ? snap.error : null
  }
}
