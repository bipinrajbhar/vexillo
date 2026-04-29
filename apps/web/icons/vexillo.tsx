import type { SVGProps } from "react";

export function VexilloMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 240"
      role="img"
      aria-label="Vexillo"
      {...props}
    >
      <title>Vexillo</title>
      <defs>
        <clipPath id="vexillo-mark-clip">
          <path d="M 30 30 L 84 30 L 120 144 L 156 30 L 210 30 L 138 210 L 102 210 Z" />
        </clipPath>
      </defs>
      <path
        className="fill-black dark:fill-white"
        d="M 30 30 L 84 30 L 120 144 L 156 30 L 210 30 L 138 210 L 102 210 Z"
      />
      <rect
        className="fill-white dark:fill-black"
        x="18"
        y="106"
        width="204"
        height="11"
      />
      <g clipPath="url(#vexillo-mark-clip)">
        <rect
          className="fill-black dark:fill-white"
          x="168"
          y="106"
          width="54"
          height="11"
        />
      </g>
    </svg>
  );
}

export function VexilloLockup(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 820 240"
      role="img"
      aria-label="Vexillo"
      {...props}
    >
      <title>Vexillo</title>
      <defs>
        <clipPath id="vexillo-lockup-clip">
          <path d="M 30 30 L 84 30 L 120 144 L 156 30 L 210 30 L 138 210 L 102 210 Z" />
        </clipPath>
      </defs>
      <path
        className="fill-black dark:fill-white"
        d="M 30 30 L 84 30 L 120 144 L 156 30 L 210 30 L 138 210 L 102 210 Z"
      />
      <rect
        className="fill-white dark:fill-black"
        x="18"
        y="106"
        width="204"
        height="11"
      />
      <g clipPath="url(#vexillo-lockup-clip)">
        <rect
          className="fill-black dark:fill-white"
          x="168"
          y="106"
          width="54"
          height="11"
        />
      </g>
      <text
        x="268"
        y="158"
        fontFamily="Geist, Inter, system-ui, -apple-system, Helvetica, Arial, sans-serif"
        fontWeight="600"
        fontSize="148"
        letterSpacing="-7"
        className="fill-black dark:fill-white"
      >
        vexillo
      </text>
    </svg>
  );
}
