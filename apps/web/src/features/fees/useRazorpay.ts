"use client";

import { useEffect, useState } from "react";

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

// Minimal Razorpay Checkout types so strict tsc compiles. The real SDK exposes
// far more; we declare only what the PAY flow in fees/me uses.
export interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayOptions {
  key: string;
  order_id: string;
  // Razorpay's amount is the smallest currency unit. We pass the paise STRING
  // issued by the order-create response verbatim (number only permitted at the
  // single annotated SDK boundary in the checkout call site).
  amount: string | number;
  currency: string;
  name?: string;
  handler?: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void };
}

export interface RazorpayInstance {
  open: () => void;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/**
 * Injects the Razorpay Checkout script once (idempotent) and reports load
 * state. Returns early as ready if `window.Razorpay` is already defined. No
 * money arithmetic happens here — it is a pure script loader.
 */
export function useRazorpay(): { ready: boolean; error: boolean } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already available (another mount injected it, or a prior session).
    if (window.Razorpay) {
      setReady(true);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHECKOUT_SRC}"]`,
    );

    const onLoad = () => setReady(true);
    const onError = () => setError(true);

    if (existing) {
      // Script tag present but not yet resolved — attach listeners to it.
      if (window.Razorpay) {
        setReady(true);
      } else {
        existing.addEventListener("load", onLoad);
        existing.addEventListener("error", onError);
      }
      return () => {
        existing.removeEventListener("load", onLoad);
        existing.removeEventListener("error", onError);
      };
    }

    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    document.body.appendChild(script);

    return () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
  }, []);

  return { ready, error };
}
