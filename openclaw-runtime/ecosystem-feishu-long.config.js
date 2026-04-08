module.exports = {
  apps: [
    {
      name: "feishu-long",
      script: "node_modules/ts-node/dist/bin.js",
      args: "modified-runtime/integrations/startup-longlink.ts",
      cwd: "/root/for-server",
      env: {
        FEISHU_APP_ID: "cli_a9587a4c10f8dcc7",
        FEISHU_APP_SECRET: "t01L6rqtn8wQy32e4eDhZb8lYpZmCjmH",
        FEISHU_RUNTIME_EXECUTE_URL: "https://frp-try.com:20203/execute",
        // 飞书长连接调用 runtime-execute 的超时：120 秒，给 multi-agent 任务留足时间
        FEISHU_RUNTIME_TIMEOUT_MS: "120000",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
    },
  ],
};
