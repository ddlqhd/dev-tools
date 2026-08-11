import type { InterventionDecision, KernelEvent } from "@devtools/shared";

export class KernelClient {
  constructor(
    readonly endpoint: string,
    readonly token?: string | null,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createTask(body: {
    requirement: string;
    repoPath?: string;
    pipeline?: string;
    configOverrides?: { autoApproveGates?: boolean; inplace?: boolean; sandbox?: boolean };
  }): Promise<{ taskId: string; branch: string }> {
    const res = await fetch(`${this.endpoint}/tasks`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`kernel createTask: ${res.status} ${await res.text()}`);
    return (await res.json()) as { taskId: string; branch: string };
  }

  async getTask(taskId: string): Promise<unknown> {
    const res = await fetch(`${this.endpoint}/tasks/${taskId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`kernel getTask: ${res.status}`);
    return res.json();
  }

  async pause(taskId: string): Promise<void> {
    await this.post(`/tasks/${taskId}/pause`);
  }

  async resume(taskId: string, instruction?: string): Promise<void> {
    await this.post(`/tasks/${taskId}/resume`, { instruction });
  }

  async abort(taskId: string): Promise<void> {
    await this.post(`/tasks/${taskId}/abort`);
  }

  async inject(taskId: string, text: string): Promise<void> {
    await this.post(`/tasks/${taskId}/instructions`, { text });
  }

  async resolveIntervention(
    taskId: string,
    requestId: string,
    decision: InterventionDecision,
  ): Promise<void> {
    await this.post(`/tasks/${taskId}/interventions/${requestId}`, decision);
  }

  async events(taskId: string, after = 0): Promise<KernelEvent[]> {
    const res = await fetch(`${this.endpoint}/tasks/${taskId}/events?after=${after}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`kernel events: ${res.status}`);
    const data = (await res.json()) as { events: KernelEvent[] };
    return data.events;
  }

  async artifact(
    taskId: string,
    artifactId: string,
  ): Promise<{ contentType: string; body: string } | null> {
    const res = await fetch(`${this.endpoint}/tasks/${taskId}/artifacts/${artifactId}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kernel artifact: ${res.status}`);
    return {
      contentType: res.headers.get("content-type") ?? "text/plain",
      body: await res.text(),
    };
  }

  private async post(path: string, body: unknown = {}): Promise<void> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`kernel ${path}: ${res.status} ${await res.text()}`);
  }
}
