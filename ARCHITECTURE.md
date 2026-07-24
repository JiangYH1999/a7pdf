# Architecture

## 目标

A7PDF 优先追求小体积、快速启动、本地处理与清晰的模块边界。

## 分层

```text
React UI
├── workspace        文档工作区与页面导航
├── tools            编辑工具和属性面板
├── annotations      批注对象模型、选择与历史记录
└── document         文档状态、页面缓存和导出任务
        │
        ▼
PDF engine adapter
├── PDF.js adapter   当前渲染实现
└── MuPDF adapter    后续渲染、写入、脱敏与高级编辑
        │
        ▼
Tauri / Rust
├── filesystem       安全的本地文件读写
├── native dialogs   系统文件选择和保存
├── jobs             后台任务与进度
└── platform         菜单、快捷键、窗口和自动更新
```

## 设计原则

1. PDF 引擎必须通过适配层访问，界面不直接依赖具体引擎。
2. 编辑操作表示为可序列化命令，以支持撤销、重做和自动保存。
3. 大文档按需渲染并限制页面缓存，避免一次性加载全部画布。
4. 文件默认只在本地处理；未来的网络功能必须明确选择加入。
5. 原文编辑属于独立里程碑，不与第一阶段批注模型耦合。
