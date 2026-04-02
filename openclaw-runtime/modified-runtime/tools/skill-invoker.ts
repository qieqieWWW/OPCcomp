export interface SkillInvocation {
  name: string;
  params: Record<string, unknown>;
}

export class SkillInvoker {
  private readonly baseUrl: string;

  constructor(
    openclawUrl: string,
    private readonly apiKey?: string,
  ) {
    this.baseUrl = openclawUrl.replace(/\/$/, "");
  }

  async invoke(skillName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/skills/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        skill: skillName,
        parameters,
      }),
    });

    return (await response.json()) as Record<string, unknown>;
  }

  async batchInvoke(skills: SkillInvocation[]): Promise<Record<string, unknown>[]> {
    return Promise.all(skills.map((skill) => this.invoke(skill.name, skill.params)));
  }

  async getAvailableSkills(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/skills`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });

    const data = (await response.json()) as { skills?: Array<{ name?: string }> };
    return (data.skills ?? []).map((skill) => skill.name).filter((name): name is string => Boolean(name));
  }
}
