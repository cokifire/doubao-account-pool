const path = require('node:path')
const { signAsync } = require('@electron/osx-sign')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  // A complete ad-hoc signature prevents Electron's linker signature from
  // becoming invalid after packaging when no Developer ID is installed.
  await signAsync({
    app: appPath,
    identity: '-',
    identityValidation: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      timestamp: 'none',
    }),
    platform: 'darwin',
  })
}
