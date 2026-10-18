/** @type {import('next').NextConfig} */
const nextConfig = {
  /*
   * 关掉左下角那个悬浮的 Next.js 开发指示器（圆形 N 图标）。
   *
   * 它只在 dev 模式出现，功能是显示路由类型/构建状态，但对演示没用 ——
   * 反而会被录进演示视频或被面试官看到，显得像没做完。
   *
   * 注意：这只影响 dev。跑 next build && next start（生产模式）本来就没有它，
   * 而且生产模式还更快、没有开发覆盖层 —— 正式演示更推荐走生产模式。
   */
  devIndicators: false,
  // ioredis / Qdrant 客户端依赖 Node 原生能力，交给 Next.js 打包会出问题，
  // 声明为外部依赖让它们在运行时按 CommonJS 加载。
  serverExternalPackages: ['ioredis', '@qdrant/js-client-rest'],

  webpack: (config) => {
    config.resolve.fallback = { fs: false };
    return config;
  },
};

export default nextConfig;
