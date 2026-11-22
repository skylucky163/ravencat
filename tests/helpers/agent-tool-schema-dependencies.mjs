/** 行为验证使用真实 JSON Schema 依赖，避免 mock 掉参数校验。 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const agentToolSchemaDependencies = Object.fromEntries(
  ['ajv', 'ajv/dist/2019', 'ajv/dist/2020', 'ajv-formats'].map((name) => [name, require(name)]),
);
