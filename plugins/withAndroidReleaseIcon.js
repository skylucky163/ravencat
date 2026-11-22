const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

module.exports = function withAndroidReleaseIcon(config) {
  return withDangerousMod(config, ['android', async (mod) => {
    // Android 只显示 108dp 图层中央的 72dp；内缩抵消裁切，让完整 logo 保留原图边距。
    // 资源只覆盖 release，debug 继续由开发版图标插件负责。
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/release/res/mipmap-anydpi-v26');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/iconBackground"/>
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.666667%"/>
    </foreground>
</adaptive-icon>
`;
    await fs.mkdir(directory, { recursive: true });
    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      await fs.writeFile(path.join(directory, name), xml);
    }
    return mod;
  }]);
};
