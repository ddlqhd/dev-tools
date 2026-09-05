import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { PageState, StatusBanner } from "../components/PageState";
import { useToast } from "../components/Toast";
import { api, type Instance } from "../api";

export function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reload = () => api.listInstances().then((r) => setInstances(r.instances));

  const terminate = async (instance: Instance) => {
    try {
      await api.terminateInstance(instance.id);
      await reload();
      toast.success(`已回收实例 ${instance.id}`);
    } catch (e) {
      toast.error(`回收实例失败：${instance.id}`, e);
    }
  };

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const t = setInterval(() => void reload().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="page-stack">
      <PageHeader
        title="实例"
        description={
          <>
            <span>{instances.length} 个内核实例</span>
            <span aria-hidden="true"> · </span>
            <span>每 5 秒自动刷新</span>
          </>
        }
      />

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className="Box">
        <div className="Box-header">
          <h2>内核实例</h2>
          <span className="Counter">{instances.length}</span>
        </div>
        {instances.length === 0 ? (
          <PageState kind="empty" title="暂无实例">
            创建任务后，调度器会按需拉起内核实例。
          </PageState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>状态</th>
                  <th>Endpoint</th>
                  <th>PID</th>
                  <th>仓库</th>
                  <th>最近心跳</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((i) => (
                  <tr key={i.id}>
                    <td className="cell-clip" title={i.id}>
                      {i.id}
                    </td>
                    <td>
                      <span className={`Label ${statusLabelClass(i.status)}`}>{i.status}</span>
                    </td>
                    <td className="muted cell-clip" title={i.endpoint}>
                      {i.endpoint}
                    </td>
                    <td>{i.pid ?? "—"}</td>
                    <td className="muted cell-clip" title={i.repo_id ?? undefined}>
                      {i.repo_id ?? "—"}
                    </td>
                    <td className="muted">{i.last_seen_at.slice(11, 19)}</td>
                    <td>
                      {(i.status === "busy" || i.status === "idle" || i.status === "starting") && (
                        <button
                          className="btn btn-danger"
                          type="button"
                          onClick={() => void terminate(i)}
                        >
                          回收
                        </button>
                      )}
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
