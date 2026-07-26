export function browserControlPrompt(windowId: string) {
  return [
    `Control the already-open Agent Rider Browser window ${windowId}.`,
    'Use Agent Rider\'s built-in Browser CLI and operate this exact window when the user asks you to browse or interact with a page.',
    `Navigate: agrider browser navigate ${windowId} 'https://example.com'`,
    `Verify: agrider browser inspect ${windowId}`,
    'Replace the example URL with the requested destination.',
    'Run agrider browser --help if needed.',
    'Do not open an external browser, create a different Browser window, discover Chrome processes, or guess a debugging endpoint.',
  ].join('\n')
}
