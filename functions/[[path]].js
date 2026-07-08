import { handleRequest } from "../worker.js";

export async function onRequest(context) {
    return handleRequest(context.request, context.env, context);
}