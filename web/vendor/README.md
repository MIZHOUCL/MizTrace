# web/vendor

- `vue.global.prod.js` — Vue 3.4.27 官方生产构建（IIFE，挂 `window.Vue`），MIT。
  来源：Vue 官方发行包 `vue/dist/vue.global.prod.js`，未做任何修改（文件头保留原版权声明）。
  升级方式：`npm pack vue@<版本>` 解出 `dist/vue.global.prod.js` 覆盖即可。

为什么 vendor 而不是 CDN 或构建：MizTrace 承诺零依赖、零网络、`git clone` 即用。
前端不引入 Vite / 构建步骤，组件直接用 Vue 的运行时模板写在 `web/app.js` 里。
