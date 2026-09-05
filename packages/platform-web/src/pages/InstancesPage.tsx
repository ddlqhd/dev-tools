import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { PageState, StatusBanner } from "../components/PageState";
import { StatusIcon, statusLabel } from "../components/StatusIcon";
import { useToast } from "../components/Toast";
import { fmtRelative } from "../format";
import { api, type Instance } from "../api";

const INSTANCE_STATUS: Record<string, string> = {
  busy: "忙碌",
  idle: "空闲",
  starting: "启动中",
};

export function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reload = () =>
    api.listInstances().then((r) =>
      setInstances(
        r.instances
          .filter((row) => row.status !== "dead")
          .map((row) => ({ ...row, repo: row.repo ?? null, tasks: row.tasks ?? [] })),
      ),
    );

  const terminate = async (instance: Instance) => {
    const label = instance.repo?.full_name ?? instance.id;
    try {
      await api.terminateInstance(instance.id);
      await reload();
      toast.success(`已回收 ${label} 的内核`);
    } catch (e) {
      toast.error(`回收失败：${label}`, e);
    }
  };

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const t = setInterval(() => void reload().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, []);

  const taskCount = instances.reduce((n, row) => n + row.tasks.length, 0);

  return (
    <div className="page-stack">
      <PageHeader
        title="实例"
        description={
          <>
            <span>
              {instances.length} 个运行中的内核
              {taskCount > 0 ? ` · ${taskCount} 个绑定任务` : ""}
            </span>
            <span aria-hidden="true"> · </span>
            <span>每仓库一个进程 · 每 5 秒刷新</span>
          </>
        }
      />

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className="Box">
        <div className="Box-header">
          <h2>运行中的内核</h2>
          <span className="Counter">{instances.length}</span>
        </div>
        {instances.length === 0 ? (
          <PageState kind="empty" title="没有正在运行的内核">
            创建任务后，调度器会按仓库拉起一个 <code>codeloop serve</code>，完成后进程会留空闲供复用。
          </PageState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>仓库</th>
                  <th>状态</th>
                  <th>任务</th>
                  <th>Endpoint</th>
                  <th>PID</th>
                  <th>心跳</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="instance-repo" title={i.repo?.full_name ?? i.id}>
                        {i.repo ? (
                          <span className="instance-repo-name">{i.repo.full_name}</span>
                        ) : (
                          <span className="muted">未知仓库</span>
                        )}
                        <span className="muted instance-id">{i.id}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`Label ${statusLabelClass(i.status)}`}>
                        {INSTANCE_STATUS[i.status] ?? i.status}
                      </span>
                    </td>
                    <td>
                      {i.tasks.length === 0 ? (
                        <span className="muted">无绑定任务</span>
                      ) : (
                        <ul className="instance-tasks">
                          {i.tasks.map((task) => (
                            <li key={task.id}>
                              <Link to={`/tasks/${task.id}`} className="instance-task">
                                <StatusIcon status={task.status} size={12} />
                                <span className="instance-task-title" title={task.title}>
                                  {task.title}
                                </span>
                                <span className="muted">
                                  {statusLabel(task.status)}
                                  {task.current_node ? ` · ${task.current_node}` : ""}
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="muted cell-clip" title={i.endpoint}>
                      {i.endpoint}
                    </td>
                    <td>{i.pid ?? "—"}</td>
                    <td className="muted" title={i.last_seen_at}>
                      {fmtRelative(i.last_seen_at)}
                    </td>
                    <td>
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => void terminate(i)}
                      >
                        回收
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabelClass(status: string): string {
  if (status === "idle") return "Label--success";
  if (status === "busy" || status === "starting") return "Label--attention";
  return "";
}
