#!/usr/bin/env node
/** Initialize the installed MCP through its generated launcher and list tools. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { launcherCommand, stopServerChild } from './launcher-command.mjs'

const launcher = process.env.STEMSTUDIO_MCP_LAUNCHER
if (!launcher) throw new Error('STEMSTUDIO_MCP_LAUNCHER is required')
const launch = launcherCommand({ launcher: resolve(launcher), server: '' })
const child = spawn(launch.command, launch.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: true,
  shell: false
})
let stdout = ''
let stderr = ''
let nextId = 0
const pending = new Map()

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.on('data', (chunk) => {
  stdout += chunk
  let newline
  while ((newline = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, newline).trim()
    stdout = stdout.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (!waiter) continue
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
  }
})
child.on('error', (error) => rejectPending(error))
child.on('close', (code) => {
  if (pending.size) rejectPending(new Error(`launcher exited ${code}: ${stderr.slice(-2000)}`))
})

function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  pending.clear()
}

function request(method, params) {
  const id = ++nextId
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-2000)}`))
    }, 30_000)
    pending.set(id, { resolve: resolvePromise, reject, timer })
  })
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'installed-launcher-smoke', version: '1' }
  })
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/initialized', params: {}
  })}\n`)
  const listed = await request('tools/list', {})
  const names = listed.tools.map((tool) => tool.name).sort()
  for (const expected of [
    'cancel_job', 'check_job', 'probe_media',
    'separate_stems', 'setup_environment', 'setup_status'
  ]) {
    if (!names.includes(expected)) throw new Error(`installed launcher missing ${expected}`)
  }
  const separation = listed.tools.find((tool) => tool.name === 'separate_stems')
  if (process.platform === 'win32') {
    const schema = JSON.stringify(separation?.inputSchema)
    if (schema.includes('mvsep') || schema.includes('max')) {
      throw new Error('installed public Windows launcher exposes an unlicensed mode')
    }
  }
  console.log(
    `Installed MCP launcher passed: ${initialized.serverInfo.name} ` +
    `${initialized.serverInfo.version}, ${names.length} tools.`
  )
} finally {
  await stopServerChild(child)
}
