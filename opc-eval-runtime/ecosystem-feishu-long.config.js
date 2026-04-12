module.exports = {
  apps: [
    {
      name: "feishu-long",
      script: "node_modules/ts-node/dist/bin.js",
      args: "modified-runtime/integrations/startup-longlink.ts",
      cwd: "/root/for-server",
      // 长连接进程必须单实例 + fork，避免 cluster worker 语义引入重复连接/重启抖动。
      exec_mode: "fork",
      env: {
        FEISHU_APP_ID: "cli_a9587a4c10f8dcc7",
        FEISHU_APP_SECRET: "t01L6rqtn8wQy32e4eDhZb8lYpZmCjmH",
        FEISHU_RUNTIME_EXECUTE_URL: "https://frp-try.com:20203/execute",
        // 飞书长连接调用 runtime-execute 的超时：300 秒，避免长任务被 120 秒提前截断
        FEISHU_RUNTIME_TIMEOUT_MS: "300000",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      node_args: "--max-old-space-size=1024",
      max_memory_restart: "1200M",
      min_uptime: "20s",
      restart_delay: 2000,
    },
  ],
};
