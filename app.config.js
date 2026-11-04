const { version, versionCode } = require('./scripts/app-version.cjs');

module.exports = ({ config }) => {
  // 根据构建环境决定应用名称和包名
  const isDevBuild = process.env.EAS_BUILD_PROFILE === 'development';
  const appName = isDevBuild ? 'KimiPhone' : 'RavenCat';
  const developmentIcon = {
    foregroundImage: "./assets/adaptive-icon.png",
    backgroundColor: "#FFFFFF"
  };
  // EAS 项目关联属于开发者账号，公开仓库不固定到维护者的项目。
  const easProjectId = process.env.EAS_PROJECT_ID;
  const easProjectOwner = process.env.EAS_PROJECT_OWNER;
  
  return {
    ...config,
    name: appName,
    slug: "KimiPhone",
    platforms: ["android"],
    scheme: "exp+kimiphone",
    version,
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    android: {
      versionCode,
      package: isDevBuild 
        ? "com.skylucky.kimiphone.dev"  // Dev Client 包名
        : "com.skylucky.kimiphone",       // Release 包名
      adaptiveIcon: isDevBuild ? developmentIcon : {
        foregroundImage: "./assets/icon.png",
        backgroundColor: "#000000"
      },
      edgeToEdgeEnabled: true,
      permissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.PACKAGE_USAGE_STATS"
      ]
    },
    // 黑底属于启动屏，应用内状态栏仍需透明，让各页面背景延伸到系统栏。
    androidStatusBar: {
      translucent: true
    },
    plugins: [
      "./plugins/withAppVersion",
      ["./plugins/withAndroidDevelopmentIcon", developmentIcon],
      "./plugins/withAndroidReleaseSigning",
      "./plugins/withFixedFontScale",
      "expo-router",
      "expo-font",
      [
        "expo-splash-screen",
        {
          image: "./assets/icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#000000"
        }
      ],
      "expo-sqlite",
      ["expo-secure-store", { configureAndroidBackup: false }],
      "./plugins/withMcpCredentialBackup",
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 33,
            usesCleartextTraffic: true
          }
        }
      ],
      [
        "expo-image-picker",
        {
          photosPermission: `允许 ${appName} 访问相册以上传图片或更新头像。`,
          cameraPermission: `允许 ${appName} 使用相机以拍照或开启视频电话画面。`
        }
      ],
      "./plugins/withImageCropColors",
      [
        "expo-camera",
        {
          cameraPermission: `允许 ${appName} 使用相机以开启视频电话画面并自动截取通话快照。`,
          microphonePermission: `允许 ${appName} 使用麦克风以进行语音通话。`
        }
      ]
    ],
    experiments: {
      typedRoutes: true
    },
    extra: {
      ...config.extra,
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {})
    },
    ...(easProjectOwner ? { owner: easProjectOwner } : {})
  };
};
