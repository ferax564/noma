/** `/api/groups`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudGroup } from "../cloud-db.js";
import {
  type CloudServerConfig,
  type Principal,
  readUser,
  requireUser,
  sqliteConstraint,
  uniqueId,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, stringInput } from "./input.js";

export async function routeGroups(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const groupId = parts[2];
  const action = parts[3];
  const memberId = parts[4];
  if (!groupId && method === "GET") {
    sendJson(res, 200, { groups: config.store.listGroups(user.id) });
    return;
  }
  if (!groupId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const group: Omit<CloudGroup, "members"> = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 100),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      config.store.createGroup(group, user.id);
    } catch (error) {
      if (sqliteConstraint(error)) throw new HttpError(409, "A group with this name already exists");
      throw error;
    }
    sendJson(res, 201, config.store.readGroup(group.id));
    return;
  }
  if (!groupId) throw new HttpError(404, "Group ID is required");
  assertCloudId(groupId, "Group");
  const group = config.store.readGroup(groupId);
  if (!group) throw new HttpError(404, "Group not found");
  const membership = group.members.find((member) => member.userId === user.id);
  if (!membership) throw new HttpError(403, "Group membership is required");
  if (!action && method === "GET") {
    sendJson(res, 200, group);
    return;
  }
  if (action === "members" && !memberId && method === "POST") {
    if (membership.role !== "manager") throw new HttpError(403, "Group manager access is required");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const userId = stringInput(input, "userId");
    await readUser(config, userId);
    const role = input.role === "manager" ? "manager" : "member";
    config.store.addGroupMember(group.id, userId, role, config.now().toISOString());
    sendJson(res, 200, config.store.readGroup(group.id));
    return;
  }
  if (action === "members" && memberId && method === "DELETE") {
    if (membership.role !== "manager") throw new HttpError(403, "Group manager access is required");
    assertCloudId(memberId, "User");
    const target = group.members.find((member) => member.userId === memberId);
    if (!target) throw new HttpError(404, "Group member not found");
    if (target.role === "manager" && group.members.filter((member) => member.role === "manager").length === 1) {
      throw new HttpError(409, "A group must keep at least one manager");
    }
    config.store.removeGroupMember(group.id, memberId, config.now().toISOString());
    sendJson(res, 200, config.store.readGroup(group.id));
    return;
  }
  throw new HttpError(404, "Unknown group route");
}
