import { useEffect, useState } from "react";
import { api, type Instance } from "../api";

export function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.listInstances().then((r) => setInstances(r.instances));

  useEffect(() => {
    void reload().catch((e: Error) => setError(e.message));
    const t = setInterval(() => void reload().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="Box">
      <div className="Box-header">
        <h2>内核实例</h2>
        <span className="Counter">{instances.length}</span>
      </div>
      {error && (
        <div className="Box-body">
          <p className="error">{error}</p>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Endpoint</th>
            <th>PID</th>
            <th>Repo</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {instances.map((i) => (
            <tr key={i.id}>
              <td>{i.id}</td>
              <td>
                <span className={`Label ${statusLabelClass(i.status)}`}>{i.status}</span>
              </td>
              <td className="muted">{i.endpoint}</td>
              <td>{i.pid ?? "-"}</td>
              <td className="muted">{i.repo_id ?? "-"}</td>
              <td className="muted">{i.last_seen_at.slice(11, 19)}</td>
              <td>
                {(i.status === "busy" || i.status === "idle" || i.status === "starting") && (
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() =>
                      void api.terminateInstance(i.id).then(() => reload())
                    }
                  >
                    回收
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!instances.length && (
        <div className="Box-body">
          <p className="muted">暂无实例</p>
        </div>
      )}
    </div>
  );
}

function statusLabelClass(status: string): string {
  if (status === "idle") return "Label--success";
  if (status === "busy" || status === "starting") return "Label--attention";
  return "";
}
