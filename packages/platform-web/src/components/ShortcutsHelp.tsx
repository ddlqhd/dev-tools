import { useEffect } from "react";
import { formatCombo } from "../shortcuts";

const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "全局",
    rows: [
      ["mod+k", "命令面板：搜索任务、执行命令"],
      ["/", "同上，直接进入搜索"],
      ["c", "新建任务"],
      ["shift+/", "打开这份快捷键速查"],
      ["escape", "关闭浮层 / 返回"],
    ],
  },
  {
    title: "跳转",
    rows: [
      ["g b", "工作台"],
      ["g i", "实例"],
      ["g s", "配置"],
    ],
  },
  {
    title: "工作台",
    rows: [
      ["f", "聚焦过滤框"],
      ["v", "看板 / 列表视图切换"],
      ["j", "下一个任务（列表视图）"],
      ["k", "上一个任务（列表视图）"],
      ["enter", "打开选中任务"],
    ],
  },
  {
    title: "任务详情",
    rows: [
      ["a", "批准当前审批"],
      ["r", "聚焦驳回意见"],
      ["e", "编辑计划"],
      ["p", "暂停 / 继续"],
      ["i", "聚焦注入输入框"],
      ["j", "下一个任务"],
      ["k", "上一个任务"],
    ],
  },
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel Box shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="Box-header">
          <h2 id="shortcuts-title">快捷键</h2>
          <button className="btn" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="Box-body shortcuts-grid">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="subsection-title">{group.title}</h3>
              <dl className="shortcuts-list">
                {group.rows.map(([combo, desc]) => (
                  <div key={`${group.title}-${combo}`} className="shortcuts-row">
                    <dt>
                      <kbd className="kbd">{formatCombo(combo)}</kbd>
                    </dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
