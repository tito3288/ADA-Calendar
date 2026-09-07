import Image from "next/image";

export function BrandLogo({ variant }: { variant: "sidebar" | "auth" }) {
  return (
    <Image
      className={`brand-logo brand-logo--${variant}`}
      src="/brand/alpha-dog-mint.svg"
      alt="Alpha Dog Agency"
      width={2550}
      height={1052}
      sizes={variant === "auth" ? "190px" : "160px"}
      loading="eager"
    />
  );
}
