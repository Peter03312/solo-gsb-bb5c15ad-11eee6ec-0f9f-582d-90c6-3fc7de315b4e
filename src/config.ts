// 运行配置，全部可通过环境变量覆盖
export const config = {
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? './data/cues.db',
  // 导演（管理员）口令；首次启动时用于初始化
  directorPassword: process.env.DIRECTOR_PASSWORD ?? 'director',
  // 监听地址
  host: process.env.HOST ?? '0.0.0.0',
};
