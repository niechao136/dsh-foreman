import { defineConfig } from 'vitest/config'

// 清理外部环境可能残留的 Git 隔离变量，避免污染测试用例与宿主进程
delete process.env.GIT_CONFIG_GLOBAL
delete process.env.GIT_CONFIG_NOSYSTEM
delete process.env.GIT_ASKPASS
delete process.env.GIT_TERMINAL_PROMPT

// 共享单一 React 实例供 DSH 客户端插件与测试运行
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
