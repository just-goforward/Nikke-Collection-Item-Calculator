import type { ReactNode } from "react";

type AlignedTextRole = "action" | "segment" | "status";

type AlignedTextProps = {
  alignmentRole: AlignedTextRole;
  children: ReactNode;
  className?: string;
};

export function AlignedText({ alignmentRole, children, className }: AlignedTextProps) {
  const roleClass = `aligned-text-${alignmentRole}`;
  return (
    <span
      className={`aligned-text ${roleClass}${className ? ` ${className}` : ""}`}
      data-align-role={alignmentRole}
    >
      {children}
    </span>
  );
}
