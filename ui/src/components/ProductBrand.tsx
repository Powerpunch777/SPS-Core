import { NavLink } from "@/lib/router";
import { cn } from "@/lib/utils";
import { PRODUCT_FULL_NAME, PRODUCT_LOGO_SRC, PRODUCT_NAME } from "@/lib/product-brand";

type ProductBrandProps = {
  compact?: boolean;
  linkToHome?: boolean;
  className?: string;
};

export function ProductBrand({ compact = false, linkToHome = true, className }: ProductBrandProps) {
  const content = (
    <>
      <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white shadow-sm">
        <img
          src={PRODUCT_LOGO_SRC}
          alt=""
          aria-hidden="true"
          className="size-full scale-[1.72] object-cover"
        />
      </span>
      {!compact ? (
        <span className="min-w-0 leading-none">
          <span className="block text-sm font-semibold tracking-normal text-foreground">{PRODUCT_NAME}</span>
          <span className="mt-0.5 block text-[10px] font-medium text-muted-foreground">{PRODUCT_FULL_NAME}</span>
        </span>
      ) : null}
    </>
  );

  const sharedClassName = cn(
    "flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );

  if (!linkToHome) {
    return <div className={sharedClassName}>{content}</div>;
  }

  return (
    <NavLink to="/" className={sharedClassName} aria-label={`${PRODUCT_FULL_NAME} home`}>
      {content}
    </NavLink>
  );
}
