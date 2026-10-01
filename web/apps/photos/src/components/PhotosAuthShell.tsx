import { GlobalStyles } from "@mui/material";
import {
    createAuthColorVariables,
    type AuthColorConfig,
} from "ente-accounts/components/auth/styles";
import { isDesktop } from "ente-base/app";
import type React from "react";
import styles from "../styles/auth.module.css";

interface PhotosAuthShellProps extends React.PropsWithChildren {
    contentWidth?: 400 | 420;
}

const photosAuthColors: AuthColorConfig = {
    primary: "#2471e8",
    primaryHover: "#1d61cc",
    primaryActive: "#1955b3",
    focus: "#2471e8",
    focusDark: "#79acff",
    link: "#555",
    linkDark: "#aaa",
    termsLink: "#555",
    termsLinkDark: "#aaa",
    passwordMessage: "#000",
    passwordMessageDark: "#fff",
    textDisabledDark: "#4d4d4d",
};

export function PhotosAuthShell({
    children,
    contentWidth = 400,
}: PhotosAuthShellProps): React.JSX.Element {
    return (
        <div
            className={styles.page}
            style={{
                minHeight: isDesktop
                    ? "calc(100svh - env(titlebar-area-height, 30px))"
                    : undefined,
            }}
        >
            <GlobalStyles styles={createAuthColorVariables(photosAuthColors)} />
            <header className={styles.brand}>Fotoro</header>
            <main className={styles.main}>
                <div
                    className={styles.content}
                    style={{ maxWidth: contentWidth }}
                >
                    {children}
                </div>
            </main>
            <footer className={styles.footer}>
                <details className={styles.privacy}>
                    <summary>Privacy &amp; open source</summary>
                    <p>Your photos are encrypted before upload.</p>
                    <div className={styles.links}>
                        <a
                            href="https://github.com/dakshbhatia/fotoro"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            View source
                        </a>
                        <a
                            href="https://github.com/ente/ente"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Built on Ente
                        </a>
                    </div>
                </details>
            </footer>
        </div>
    );
}
