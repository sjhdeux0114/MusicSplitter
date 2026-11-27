const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  console.log(`Embedding icon into ${exePath} from ${icoPath}`);
  await rcedit(exePath, {
    icon: icoPath
  });
};
