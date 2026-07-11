/**
 * Emit the small distribution descriptor consumed by the packaged headless
 * MCP bridge. Identity values come from electron-builder extraMetadata, so
 * generic source code never guesses a distribution from its install path.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function afterPack(context) {
  const distribution = context.packager.config.extraMetadata?.distribution ?? {}
  const userDataFolder = distribution.userDataFolder ?? 'stem-studio'
  const descriptor = {
    schemaVersion: 1,
    userDataFolder,
    appId: distribution.appId ?? context.packager.appInfo.id,
    displayName: distribution.displayName ?? 'Stem Studio',
    isCommunityBuild: distribution.isCommunityBuild === true,
    mcpLauncher: context.electronPlatformName === 'win32'
      ? 'mcp/stem-studio-mcp.cmd'
      : 'mcp/stem-studio-mcp'
  }
  const resourcesDirectory = context.packager.getResourcesDir(context.appOutDir)
  await mkdir(resourcesDirectory, { recursive: true })
  await writeFile(
    join(resourcesDirectory, 'stem-studio-distribution.json'),
    `${JSON.stringify(descriptor, null, 2)}\n`
  )

  const mcpDirectory = join(resourcesDirectory, 'mcp')
  await mkdir(mcpDirectory, { recursive: true })
  await writeFile(
    join(mcpDirectory, 'package.json'),
    `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`
  )
  const executableName =
    context.packager.platformSpecificBuildOptions.executableName ??
    context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'win32') {
    await writeFile(
      join(mcpDirectory, 'stem-studio-mcp.cmd'),
      `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n` +
        `"%~dp0..\\..\\${executableName}.exe" "%~dp0index.js" %*\r\n`
    )
  } else {
    const executable = context.electronPlatformName === 'darwin'
      ? `../../MacOS/${context.packager.appInfo.productFilename}`
      : `../../${executableName}`
    const launcher = join(mcpDirectory, 'stem-studio-mcp')
    await writeFile(
      launcher,
      '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
        `ELECTRON_RUN_AS_NODE=1 exec "$HERE/${executable}" "$HERE/index.js" "$@"\n`
    )
    await chmod(launcher, 0o755)
  }
}
