import { create } from "zustand";
import { persist } from "zustand/middleware";
import { decodeAuthClaims } from "@/lib/jwt";

interface UserInfo {
  id: string;
  email: string;
  // Legacy GatePass claim — widened from the old 5-member union to string so a
  // valid logged-in ACCOUNTANT/FACULTY/WARDEN can be represented. Legacy guards
  // comparing user.role === "STUDENT" still compile (string literals assignable
  // to string). Authorization NEVER uses role; it uses permissions (see authz).
  role: string;
  accountStatus: string;
  profile?: any;
}

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  // RBAC claims decoded from the JWT at login + rehydrated from persistence:
  roles: string[];
  permissions: string[];
  permissionsVersion: number | null;
  membershipId: string | null;
  institutionId: string | null;
  hydrated: boolean;
  setAuth: (token: string, user: UserInfo) => void;
  logout: () => void;
  setHydrated: () => void;
}

// The persisted slice (partialize output) — what migrate must return.
type PersistedAuth = Pick<
  AuthState,
  | "token"
  | "user"
  | "roles"
  | "permissions"
  | "permissionsVersion"
  | "membershipId"
  | "institutionId"
>;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      roles: [],
      permissions: [],
      permissionsVersion: null,
      membershipId: null,
      institutionId: null,
      hydrated: false,
      setAuth: (token, user) => {
        const claims = decodeAuthClaims(token);
        set({
          token,
          user,
          roles: claims.roles ?? [],
          permissions: claims.permissions ?? [],
          permissionsVersion: claims.permissionsVersion ?? null,
          membershipId: claims.membershipId ?? null,
          institutionId: claims.institutionId ?? null,
        });
      },
      logout: () =>
        set({
          token: null,
          user: null,
          roles: [],
          permissions: [],
          permissionsVersion: null,
          membershipId: null,
          institutionId: null,
        }),
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "campusgate-auth",
      version: 1,
      // zustand's migrate return value becomes the rehydrated state, so it must
      // be a valid state object. For any pre-v1 session (which predates the RBAC
      // claim shape) return an explicit cleared slice to force a clean re-login.
      migrate: (persisted, fromVersion): PersistedAuth =>
        fromVersion < 1
          ? {
              token: null,
              user: null,
              roles: [],
              permissions: [],
              permissionsVersion: null,
              membershipId: null,
              institutionId: null,
            }
          : (persisted as PersistedAuth),
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        roles: state.roles,
        permissions: state.permissions,
        permissionsVersion: state.permissionsVersion,
        membershipId: state.membershipId,
        institutionId: state.institutionId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    }
  )
);
