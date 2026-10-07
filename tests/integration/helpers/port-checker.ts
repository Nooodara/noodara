import { createServer } from 'node:net';

export interface PortCheckResult {
  success: boolean;
  port: number;
  error?: 'other-process' | 'stale-noodara-stack';
  message?: string;
  skipped?: boolean;
}

/**
 * Checks if a container is part of a stale Noodara test stack by checking for
 * the `noodara.test` label.
 */
export function isNoodaraContainer(container: any): boolean {
  return container?.Labels?.['noodara.test'] === 'true';
}

/**
 * Checks if a port is in use and, if so, distinguishes between:
 * - Another process holding the port
 * - A stale Noodara test stack (containers with noodara.test label)
 *
 * Returns early if NOODARA_TEST_PORT_OVERRIDE env var is set, since an explicit
 * override bypasses port 3000 entirely.
 *
 * This precheck runs before any containers or databases are started, so stale
 * cleanup is left to a human (or CI cleanup scripts) and the integration test
 * fails fast with a clear message instead of hanging or leaving orphans.
 */
export async function checkPort(port: number, dockerClient?: any): Promise<PortCheckResult> {
  // If an explicit alternative port is configured, skip the check entirely.
  if (process.env.NOODARA_TEST_PORT_OVERRIDE !== undefined) {
    return {
      success: true,
      port,
      skipped: true,
    };
  }

  // Check if the port is actually in use by attempting to bind.
  const portInUse = await isPortInUse(port);
  if (!portInUse) {
    return {
      success: true,
      port,
    };
  }

  // Port is in use. Get Docker client if not provided, to check for stale containers.
  const client = dockerClient ?? (await getDockerClient());
  const containers = await client.container.list();
  const noodaraContainers = containers.filter(isNoodaraContainer);

  if (noodaraContainers.length > 0) {
    // Stale Noodara test stack is holding the port.
    return {
      success: false,
      port,
      error: 'stale-noodara-stack',
      message: `Port ${port} is held by a stale Noodara test stack (${noodaraContainers.length} container(s)). ` +
        `Clean up with: docker rm -f $(docker ps -aq --filter label=noodara.test=true) && ` +
        `docker network rm $(docker network ls --filter label=noodara.test=true -q)`,
    };
  }

  // Port is in use by another process.
  return {
    success: false,
    port,
    error: 'other-process',
    message: `Port ${port} is already in use by another process. ` +
      `Free it with: lsof -ti:${port} | xargs kill -9 (or kill the other process manually).`,
  };
}

/**
 * Attempts to bind to a port to check if it's in use.
 * Returns true if port is in use, false if available.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use
      } else {
        resolve(true); // Assume in use on other errors
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false); // Port is free
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Gets the Testcontainers Docker client for checking containers.
 */
async function getDockerClient() {
  const { getContainerRuntimeClient } = await import('testcontainers');
  return getContainerRuntimeClient();
}
