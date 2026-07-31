import type { RouteSummary } from "@way-memory/contracts";
import { ref } from "vue";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function endpoint(path: string) {
  return `${apiBase}${path}`;
}

function headers(): HeadersInit {
  const token = sessionStorage.getItem("way-memory.dashboard-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useRoutes() {
  const routes = ref<RouteSummary[]>([]);
  const routeBusy = ref(false);
  const routeError = ref("");

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: { ...headers(), "content-type": "application/json", ...init?.headers },
    });
    const body = await response.json() as RouteSummary & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `API ${response.status}`);
    return body;
  }

  async function refreshRoutes() {
    try {
      routes.value = await request("/api/routes") as unknown as RouteSummary[];
      routeError.value = "";
    } catch (error) {
      routeError.value = error instanceof Error ? error.message : "路线列表加载失败";
    }
  }

  async function createRoute(name: string) {
    routeBusy.value = true;
    try {
      const route = await request("/api/routes", { method: "POST", body: JSON.stringify({ name }) }) as RouteSummary;
      routes.value = [route, ...routes.value];
      routeError.value = "";
      return route;
    } finally {
      routeBusy.value = false;
    }
  }

  async function attachObservation(routeId: string, sessionId: string) {
    routeBusy.value = true;
    try {
      const route = await request(`/api/routes/${encodeURIComponent(routeId)}/observations`, { method: "POST", body: JSON.stringify({ sessionId }) }) as RouteSummary;
      routes.value = routes.value.map((item) => item.routeId === route.routeId ? route : item);
      routeError.value = "";
      return route;
    } finally {
      routeBusy.value = false;
    }
  }

  async function publishRoute(routeId: string) {
    routeBusy.value = true;
    try {
      const route = await request(`/api/routes/${encodeURIComponent(routeId)}/publish`, { method: "POST" }) as RouteSummary;
      routes.value = routes.value.map((item) => item.routeId === route.routeId ? route : item);
      routeError.value = "";
      return route;
    } finally {
      routeBusy.value = false;
    }
  }

  return { routes, routeBusy, routeError, refreshRoutes, createRoute, attachObservation, publishRoute };
}
