import { ApiError } from "@/lib/api";

/** 409 `insufficient stock`. */
export function isInsufficientStock(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.data?.error === "insufficient stock";
}

/** 409 `asset is terminal`. */
export function isAssetTerminal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.data?.error === "asset is terminal";
}
