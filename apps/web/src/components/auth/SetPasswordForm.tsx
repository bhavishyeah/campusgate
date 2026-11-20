"use client";

import { useState } from "react";
import { validateNewPassword } from "@/lib/accountLinks";

interface Props {
  submitLabel: string;
  busyLabel: string;
  onSubmit: (password: string) => Promise<void>;
  error?: string;
}

export function SetPasswordForm({ submitLabel, busyLabel, onSubmit, error }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateNewPassword(password, confirm);
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError("");
    setLoading(true);
    try {
      await onSubmit(password);
    } finally {
      setLoading(false);
    }
  };

  const shown = localError || error;

  return (
    <form onSubmit={handle} className="space-y-4">
      <div>
        <label htmlFor="new-password" className="label">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          required
          autoComplete="new-password"
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="label">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          className="input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
        />
      </div>
      {shown && (
        <div
          className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm"
          role="alert"
        >
          {shown}
        </div>
      )}
      <button type="submit" className="btn-primary w-full" disabled={loading}>
        {loading ? busyLabel : submitLabel}
      </button>
    </form>
  );
}
