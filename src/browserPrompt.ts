export function browserControlPrompt(windowId: string) {
  return [
    `Control the already-open Agent Rider Browser window ${windowId}.`,
    'Use Agent Rider\'s built-in Browser CLI and operate this exact window when the user asks you to browse or interact with a page.',
    `Navigate: agrider browser navigate ${windowId} 'https://example.com'`,
    `Verify: agrider browser inspect ${windowId}`,
    'Replace the example URL with the requested destination.',
    'Auto mode keeps ordinary pages in the Embedded Browser and routes signed-in or sensitive sites to normal External Chrome through OpenCLI.',
    'If OpenCLI is missing, keep using this same Browser window: Agent Rider will ask the user for approval, install the CLI in user data without sudo, start a persistent node-local Chrome profile over WebRTC, and show the official Chrome Web Store inside the panel for the one required extension approval.',
    'When inspect reports mode "external", use the exact opencliProfile and opencliSession it returns for page state and interaction. The user handles sign-in, MFA, CAPTCHA, and security approval in the node-local Chrome shown in the Browser panel.',
    'Run agrider browser --help if needed.',
    'Do not create a different Browser window, launch an unrelated browser session, discover Chrome processes, or guess a debugging endpoint.',
  ].join('\n')
}
