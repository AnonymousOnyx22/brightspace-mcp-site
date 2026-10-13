import { activatePage, checkout, license, manage, windowsSetupFile } from "../lib/pro.mjs";

export default async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/pro/activate" && req.method === "GET") return activatePage(req);
  if (pathname === "/pro/setup.cmd" && req.method === "GET") return windowsSetupFile(req);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  if (pathname === "/api/checkout") return checkout(req);
  if (pathname === "/api/license") return license(req);
  if (pathname === "/api/manage") return manage(req);
  return new Response("Not found", { status: 404 });
};

export const config = { path: ["/api/checkout", "/api/license", "/api/manage", "/pro/activate", "/pro/setup.cmd"] };
