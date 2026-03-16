'use client';

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";
import { Sankofa, type SankofaInitOptions } from "@sankofa/browser";

const SankofaContext = createContext(Sankofa);

export function SankofaProvider(props: {
  children: ReactNode;
  options: SankofaInitOptions;
  shutdownOnUnmount?: boolean;
}) {
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void Sankofa.init(props.options);
    }

    return () => {
      if (props.shutdownOnUnmount) {
        void Sankofa.shutdown();
      }
    };
  }, [props.options, props.shutdownOnUnmount]);

  return (
    <SankofaContext.Provider value={Sankofa}>
      {props.children}
    </SankofaContext.Provider>
  );
}

export function useSankofa() {
  return useContext(SankofaContext);
}

export { Sankofa };
export type { SankofaInitOptions } from "@sankofa/browser";
