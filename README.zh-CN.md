# Neat SQLite

[English](README.md) | 简体中文

在 VS Code 中浏览和编辑本地 SQLite 数据库。通过支持搜索的侧栏切换数据表，折叠侧栏后使用表格上方的下拉框，在紧凑的表格界面里修改记录。

- 分页浏览数据表和只读视图，支持自然顺序、升序、降序和各列独立筛选
- 构建文本、正则、值、数字、空、非空或自定义 WHERE 条件，下方实时预览 SQL；不同列以 AND 组合
- 选择行、列或不连续单元格；剪贴板操作要求完整矩形选区
- 查看字段、主键、索引、外键和建表 SQL
- 暂存单元格修改、新增和删除记录，按 Ctrl/Cmd+S 通过一个事务统一保存
- 保留 64 位整数精度，明确区分 NULL 与空字符串
- 复制粘贴表格数据，导出 CSV，创建一致的数据库快照
- 支持浅色、深色主题和中英文界面

## 安装和使用

运行 `npm run package` 构建当前平台的 VSIX，在 VS Code 中选择 **扩展 → 从 VSIX 安装…**。打开 `.sqlite`、`.sqlite3`、`.db` 或 `.db3` 文件，或运行 **Neat SQLite: Open Database** 命令。

切换数据表保留待保存修改。Ctrl/Cmd+S 统一提交；违反数据库约束或发现外部修改时停止保存，并保留待保存内容。撤销与重做作用于上次保存或还原之后的修改。视图、虚拟表、生成列和 BLOB 值只读。暂不支持 SQLCipher 加密数据库和远程文件。

**保存数据库快照** 通过 SQLite 备份 API 复制已提交数据，待保存修改保留在编辑器中。**另存为** 生成包含待保存修改的数据库副本。CSV 导出使用当前表与当前查询；NULL 和空字符串均导出为空 CSV 字段。

正则由后端 RE2 在 SQLite 原生条件和排序之后匹配，匹配完成后才切分结果页，并有明确预算；其他筛选由 SQLite 执行。自定义仅接受受约束的 WHERE 表达式，不能执行 SQL 语句或访问外部资源。值枚举覆盖完整列与待保存修改，超过限制明确报错。

## 本地开发

需要 Node.js 20.17 及以上版本和 npm：

```sh
npm install
npm run typecheck
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:ui
npm run package
```

VSIX 输出至 `release/`，对应当前操作系统与 CPU 架构。包内 SQLite 原生模块需要与安装目标平台匹配。运行 `npm run sample` 可生成用于手动体验的 `examples/sample.sqlite`。

## 许可证

AGPL-3.0-only。详见 [LICENSE](LICENSE)。
