import { Router } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { converse } from "@/services/assistant.service";
import { route } from "../http";

// /api/assistant: the chat box. The page keeps the conversation and sends it with each new message.
export const assistant = Router();
assistant.post("/assistant", route(async ({ user, body }) => converse(user!, (body.messages ?? []) as Anthropic.MessageParam[])));
