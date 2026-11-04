import { ApiError } from "@/lib/api";

/** 404 `no student profile`: the signed-in user has no StudentProfile. */
export function isNoStudentProfile(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.data?.error === "no student profile";
}
