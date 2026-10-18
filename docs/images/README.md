# 截图目录

README 里引用的页面截图放这里，用相对路径引用：

```markdown
![对话页](docs/images/03-chat.png)
```

## 建议的文件命名

| 文件 | 内容 |
|---|---|
| `01-knowledge-bases.png` | 知识库列表 |
| `02-upload.png` | 上传文档页 |
| `03-chat.png` | 对话页（带引用角标 + 来源卡片）**最有说服力** |
| `04-eval.png` | 质量报告 / 评测表格 |
| `05-audit.png` | 审计日志 |

## 截图前注意

- **打码个人信息**：侧边栏里的邮箱、公司名、内部 IP
- 统一视口宽度（建议 1440×900），裁掉浏览器外框
- 用 PNG，别用 WebP（GitHub 渲染兼容性不稳定）
- 单张控制在 500KB 内：`sips -Z 1600 --setProperty formatOptions 80 in.png --out out.png`
