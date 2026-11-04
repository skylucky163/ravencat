// 自定义 Expo Router 入口：先注册后台运行时，再交由 Router 注册根组件。

// 必须最先导入 gesture handler
import 'react-native-gesture-handler';

import { AppRegistry } from 'react-native';
import {
  configureBackgroundExecutionRuntime,
  configureApplicationExecutionHost,
} from '@host';

// 原生独占这个持续身份的结束；它不执行循环、不获取 CPU 锁，也不随单条请求结束。
AppRegistry.registerHeadlessTask('RavenCatApplicationExecution', () => () => new Promise(() => {}));
configureBackgroundExecutionRuntime();
configureApplicationExecutionHost();

// 必须最后加载，确保后台任务与运行时先于路由根组件完成注册。
require('expo-router/entry');
