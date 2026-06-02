import React, { useEffect, useRef, useState } from "react";
import { CONFIG } from "lib/config";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import { Button } from "components/ui/Button";
import { Label } from "components/ui/Label";
import { useAppTranslation } from "lib/i18n/useAppTranslations";
import { decodePortalToken } from "./decodePortalToken";
import { getJwt, getMinigamesApiUrl, getUrl } from "./url";
import {
  getPlayerEconomySession,
  getPortalPlayerProfile,
  postPlayerEconomyAction,
} from "./api";
import {
  asRecord,
  buildPortalPlayerData,
  firstString,
} from "./playerData";
import {
  buildEconomyMetaFromSession,
  type BootstrapContext,
  type MinigameSessionEconomyMeta,
  type MinigameSessionResponse,
} from "./types";
import {
  emptySessionMinigame,
  normalizeMinigameFromApi,
} from "./runtimeHelpers";
import { MinigameSessionProvider } from "./sessionProvider";
import { requestClosePortal } from "./closePortal";

function resolveSessionFarmId(
  session: MinigameSessionResponse,
): number | undefined {
  const farm = session.farm as Record<string, unknown>;
  const candidates = [
    farm.id,
    farm.farmId,
    farm.farmID,
    farm.fid,
    farm.farm_id,
  ];
  for (const candidate of candidates) {
    const parsed =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string"
          ? Number(candidate)
          : undefined;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export type PortalBootstrapConfig = {
  offlineActions: Record<string, unknown>;
  bootstrapAction?: string;
  offlineMinigame?: () => MinigameSessionResponse["playerEconomy"];
  /** With offline mode, supplies `items` / `descriptions` for the ui-resources dashboard. */
  offlineEconomyMeta?: MinigameSessionEconomyMeta;
};

function resolvePortalProfileFarmId(
  portalProfile?: Record<string, unknown>,
): number | undefined {
  const farm = asRecord(portalProfile);
  if (!farm) return undefined;

  const candidates = [
    farm.id,
    farm.farmId,
    farm.farmID,
    farm.fid,
    farm.farm_id,
  ];

  for (const candidate of candidates) {
    const parsed =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string"
          ? Number(candidate)
          : undefined;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

async function tryBootstrapAction(
  token: string,
  action: string,
  economy: MinigameSessionResponse["playerEconomy"],
): Promise<MinigameSessionResponse["playerEconomy"]> {
  try {
    const { playerEconomy: next } = await postPlayerEconomyAction({
      token,
      action,
    });
    return normalizeMinigameFromApi(next);
  } catch {
    return economy;
  }
}

type Phase = "unauthorised" | "loading" | "error" | "ready";

const MinigamePortalBootstrapOverlay: React.FC<{
  phase: Phase;
  errorMessage: string | null;
  onRetry: () => void;
}> = ({ phase, errorMessage, onRetry }) => {
  const { t } = useAppTranslation();

  if (phase === "ready") {
    return null;
  }

  if (phase === "unauthorised") {
    return (
      <Modal show>
        <Panel>
          <div className="p-2">
            <Label type="danger">{t("error")}</Label>
            <span className="text-sm my-2 block">{t("session.expired")}</span>
          </div>
          <Button onClick={() => requestClosePortal()}>{t("close")}</Button>
        </Panel>
      </Modal>
    );
  }

  if (phase === "error") {
    return (
      <Modal show>
        <Panel>
          <div className="p-2">
            <Label type="danger">{t("error")}</Label>
            <span className="text-sm my-2 block">
              {errorMessage || t("error.wentWrong")}
            </span>
          </div>
          <Button onClick={onRetry}>{t("retry")}</Button>
        </Panel>
      </Modal>
    );
  }

  return (
    <Modal show>
      <Panel>
        <div className="p-4 flex flex-col items-center gap-2">
          <p className="text-sm">{t("loading")}</p>
          <span className="text-xs opacity-70">
            {t("last.updated")}
            {CONFIG.CLIENT_VERSION}
          </span>
        </div>
      </Panel>
    </Modal>
  );
};

/**
 * Loads Minigames session (or offline stub), then provides {@link useMinigameSession}.
 * Replaces the previous xstate-based portal bootstrap.
 */
export const MinigamePortalProvider: React.FC<
  PortalBootstrapConfig & { children: React.ReactNode }
> = ({
  children,
  offlineActions,
  bootstrapAction,
  offlineMinigame,
  offlineEconomyMeta,
}) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [bootstrap, setBootstrap] = useState<BootstrapContext | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const configRef = useRef({
    offlineActions,
    bootstrapAction,
    offlineMinigame,
    offlineEconomyMeta,
  });
  configRef.current = {
    offlineActions,
    bootstrapAction,
    offlineMinigame,
    offlineEconomyMeta,
  };

  useEffect(() => {
    let cancelled = false;
    const cfg = configRef.current;

    (async () => {
      const jwt = getJwt() ?? "";
      const mainApiUrl = getUrl();
      const minigamesApiUrl = getMinigamesApiUrl();

      if ((mainApiUrl || minigamesApiUrl) && !jwt) {
        if (!cancelled) {
          setPhase("unauthorised");
        }
        return;
      }

      if (!cancelled) {
        setPhase("loading");
        setErrorMessage(null);
      }

      try {
        if (!mainApiUrl && !minigamesApiUrl) {
          const portalId = (CONFIG.PORTAL_APP ?? "").trim();
          const playerData = buildPortalPlayerData({
            jwt: "",
            portalId,
          });
          const ctx: BootstrapContext = {
            id: 0,
            jwt: "",
            portalId,
            farm: { balance: "0" },
            playerEconomy:
              cfg.offlineMinigame?.() ?? emptySessionMinigame(),
            actions: cfg.offlineActions,
            economyMeta: cfg.offlineEconomyMeta,
            playerData,
          };
          if (!cancelled) {
            setBootstrap(ctx);
            setPhase("ready");
          }
          return;
        }

        const { farmId, portalId: fromJwt } = decodePortalToken(jwt);
        const portalId = fromJwt ?? (CONFIG.PORTAL_APP ?? "").trim();
        if (!portalId) {
          throw new Error(
            "Portal JWT is missing portalId; re-open the minigame from the game or set VITE_PORTAL_APP.",
          );
        }

        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log("[MinigamePortal] bootstrap", {
            portalId,
            mainApiUrl: mainApiUrl ?? "(none)",
            minigamesApiUrl: minigamesApiUrl ?? "(none)",
            hasJwt: !!jwt,
          });
        }

        let portalProfile: Record<string, unknown> | undefined;
        let session: MinigameSessionResponse | undefined;

        if (mainApiUrl) {
          try {
            portalProfile = await getPortalPlayerProfile({ token: jwt, portalId });
            if (import.meta.env?.DEV) {
              // eslint-disable-next-line no-console
              console.log("[MinigamePortal] portal player profile loaded");
            }
          } catch (error) {
            // Non-fatal: portal player profile enriches player data but is not required
            // to boot the app. Log the error and continue with whatever is available.
            // eslint-disable-next-line no-console
            console.warn(
              "[MinigamePortal] Portal player profile unavailable — continuing with JWT data.",
              {
                url: `${mainApiUrl}/portal/${portalId}/player`,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        if (minigamesApiUrl) {
          try {
            session = await getPlayerEconomySession({ token: jwt });
            if (import.meta.env?.DEV) {
              // eslint-disable-next-line no-console
              console.log("[MinigamePortal] minigame session loaded");
            }
          } catch (error) {
            // Non-fatal: minigame session enriches economy data but is not required
            // to boot the app. Log the error and continue with offline economy.
            // eslint-disable-next-line no-console
            console.warn(
              "[MinigamePortal] Minigame session unavailable — continuing with offline economy.",
              {
                url: `${minigamesApiUrl}/data?type=session`,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        let playerEconomy = session
          ? normalizeMinigameFromApi(session.playerEconomy)
          : cfg.offlineMinigame?.() ?? emptySessionMinigame();
        if (cfg.bootstrapAction && session) {
          playerEconomy = await tryBootstrapAction(
            jwt,
            cfg.bootstrapAction,
            playerEconomy,
          );
        }

        const playerData = buildPortalPlayerData({
          jwt,
          portalId,
          minigameSession: session,
          portalProfile,
        });
        // eslint-disable-next-line no-console
        console.log("[BumpkinDiag] raw portalProfile:", JSON.stringify(portalProfile));
        // eslint-disable-next-line no-console
        console.log("[BumpkinDiag] raw session.farm:", JSON.stringify(session?.farm));
        // eslint-disable-next-line no-console
        console.log("[BumpkinDiag] resolvedAvatar:", JSON.stringify(playerData.resolvedAvatar));
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.log("[MinigamePortal] resolved bumpkin pipeline", {
            resolvedAvatarSource: playerData.resolvedAvatar.source,
            resolvedAvatarEquipped: playerData.resolvedAvatar.equipped,
            resolvedAvatarTokenUri: playerData.resolvedAvatar.tokenUri,
            profileBumpkin: playerData.resolvedProfile.bumpkin,
            sessionBumpkin: session?.farm.bumpkin,
            portalProfileBumpkin: asRecord(portalProfile)?.bumpkin,
          });
        }

        const resolvedFarmId =
          farmId ??
          playerData.resolvedProfile.farmId ??
          (session ? resolveSessionFarmId(session) : undefined) ??
          resolvePortalProfileFarmId(portalProfile) ??
          0;

        const portalFarm = asRecord(portalProfile);
        const resolvedFarmBumpkin =
          portalFarm?.bumpkin ??
          session?.farm.bumpkin ??
          playerData.resolvedProfile.bumpkin;

        const ctx: BootstrapContext = {
          id: resolvedFarmId,
          jwt,
          portalId,
          farm: {
            ...(session?.farm ?? { balance: "0" }),
            balance:
              firstString(
                playerData.resolvedProfile.balance,
                session?.farm.balance,
                portalFarm?.balance,
              ) ?? "0",
            username:
              firstString(
                playerData.resolvedProfile.username,
                session?.farm.username,
                portalFarm?.username,
                portalFarm?.displayName,
                portalFarm?.name,
              ) ?? undefined,
            bumpkin: resolvedFarmBumpkin,
          },
          playerEconomy,
          actions: session?.actions ?? cfg.offlineActions,
          economyMeta: session
            ? buildEconomyMetaFromSession(session)
            : cfg.offlineEconomyMeta,
          playerData,
        };
        // eslint-disable-next-line no-console
        console.log(
          "[BumpkinDiag] resolved farm.bumpkin equipped:",
          JSON.stringify((ctx.farm.bumpkin as any)?.equipped),
        );
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.log("[BumpkinDiag] bootstrap.farm.bumpkin:", JSON.stringify(ctx.farm.bumpkin));
          setBootstrap(ctx);
          setPhase("ready");
        }
      } catch (e) {
        if (!cancelled) {
          const fallbackJwt = getJwt() ?? "";
          const decoded = decodePortalToken(fallbackJwt);
          const fallbackPortalId =
            decoded.portalId ?? (CONFIG.PORTAL_APP ?? "").trim();
          const fallbackPlayerData = buildPortalPlayerData({
            jwt: fallbackJwt,
            portalId: fallbackPortalId,
          });

          // eslint-disable-next-line no-console
          console.warn(
            "[MinigamePortal] Bootstrap failed; continuing with fallback context.",
            {
              error: e instanceof Error ? e.message : String(e),
              portalId: fallbackPortalId || "(none)",
            },
          );

          const fallbackCtx: BootstrapContext = {
            id: decoded.farmId ?? fallbackPlayerData.resolvedProfile.farmId ?? 0,
            jwt: fallbackJwt,
            portalId: fallbackPortalId,
            farm: {
              balance: fallbackPlayerData.resolvedProfile.balance ?? "0",
              username: fallbackPlayerData.resolvedProfile.username,
              bumpkin: fallbackPlayerData.resolvedProfile.bumpkin,
            },
            playerEconomy: cfg.offlineMinigame?.() ?? emptySessionMinigame(),
            actions: cfg.offlineActions,
            economyMeta: cfg.offlineEconomyMeta,
            playerData: fallbackPlayerData,
          };

          setBootstrap(fallbackCtx);
          setErrorMessage(null);
          setPhase("ready");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const onRetry = () => {
    setBootstrap(null);
    setRetryKey((k) => k + 1);
    setPhase("loading");
  };

  if (phase === "ready" && bootstrap) {
    return (
      <MinigameSessionProvider bootstrap={bootstrap}>
        {children}
      </MinigameSessionProvider>
    );
  }

  return (
    <>
      <MinigamePortalBootstrapOverlay
        phase={phase}
        errorMessage={errorMessage}
        onRetry={onRetry}
      />
    </>
  );
};
