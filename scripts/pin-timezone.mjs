/**
 * 测试统一在一个固定时区里跑（npm test 通过 --import 预加载；文件名故意不带 test，免得被 node --test 当成测试文件）。
 *
 * 为什么：不少夹具是在 UTC+8 的机器上写的 —— 时间戳落在某一天的窗口内、hhmm() 渲染成几点，
 * 换台机器就飘：GitHub Actions 是 UTC，美西的贡献者是 UTC-7，同一套测试一个红一个绿。
 * 钉在 Asia/Shanghai 而不是 UTC：非零偏移才能暴露「把 UTC 当本地时间」这类 bug。
 * 运行时改 TZ 在 macOS / Linux 一定生效；Windows 上若不生效，也只是退回运行机自己的时区，
 * 夹具在 UTC 下同样落在窗口内（CI 已验证）。需要真正切换时区的用例（timezone.test.js）自己会探测并跳过。
 */
process.env.TZ = 'Asia/Shanghai';
