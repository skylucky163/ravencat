const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

// 公共配置不绑定开发者的网卡；连接方式由 Expo 启动参数决定。
const config = getDefaultConfig(__dirname);
const projectRoot = __dirname.split(path.sep)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('[/\\\\]');

// 临时源码副本和原生构建产物不属于应用依赖图；Windows 逐目录监听不能继续扫描它们。
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList),
  new RegExp(`^${projectRoot}[/\\\\](?:tmp|\\.tmp|artifacts|\\.expo-verify-flatlist)(?:[/\\\\]|$)`),
  new RegExp(`^${projectRoot}[/\\\\]android[/\\\\](?:app[/\\\\])?(?:build|\\.gradle|\\.cxx)(?:[/\\\\]|$)`),
  new RegExp(`^${projectRoot}[/\\\\]modules[/\\\\][^/\\\\]+[/\\\\]android[/\\\\](?:build|\\.gradle|\\.cxx)(?:[/\\\\]|$)`),
];

module.exports = config;
