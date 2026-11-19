module.exports = {
  apps: [{
    name: 'transport-fps',
    script: 'server/index.js',
    cwd: '/root/work/transport-ship-fps',
    node_args: [],
    instances: 1,
    autorestart: true,
    max_restarts: 100,
    min_uptime: '10s',
    restart_delay: 2000,
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production', PORT: '3028' },
    out_file: '/root/work/transport-ship-fps/data/out.log',
    error_file: '/root/work/transport-ship-fps/data/err.log',
    merge_logs: true,
    time: true
  }]
};
