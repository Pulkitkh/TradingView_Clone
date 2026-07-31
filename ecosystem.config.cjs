// PM2 process config — keeps the server + poller running forever and restarts
// it on crash or reboot.
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'trendingdata',
      cwd: __dirname,
      script: 'server/index.js',
      node_args: '--env-file=server/.env',
      instances: 1, // single instance: the store and SSE hub are in-process
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '600M', // headless Chromium can creep
      env: { NODE_ENV: 'production' },
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
