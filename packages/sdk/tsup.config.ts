import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 把 shared 规则包打进单文件，SDK 产物可独立嵌入页面
  noExternal: [/@pointwise\/shared/],
});
