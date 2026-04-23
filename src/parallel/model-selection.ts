export function isApiAgentType(agentType?: string): boolean {
  return agentType === 'api' || agentType === 'openai';
}

export function resolveParallelRoleModel(
  agentType: string | undefined,
  fallbackModel: string,
  configuredModel?: string,
): string | undefined {
  if (isApiAgentType(agentType)) {
    return configuredModel;
  }

  return configuredModel ?? fallbackModel;
}
