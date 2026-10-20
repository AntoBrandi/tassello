// Line icons on a 24x24 grid, drawn with the current text colour

import type { ReactNode, SVGProps } from 'react';

function icon(content: ReactNode) {
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {content}
      </svg>
    );
  };
}

export const RobotIcon = icon(
  <>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 4h6" />
    <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
    <path d="M2 13v3M22 13v3" />
  </>,
);
// Four tiles of a mosaic, the logo
export const TasselloIcon = icon(
  <>
    <rect x="3" y="3" width="8" height="10" rx="1.5" />
    <rect x="13" y="3" width="8" height="6" rx="1.5" />
    <rect x="3" y="15" width="8" height="6" rx="1.5" />
    <rect x="13" y="11" width="8" height="10" rx="1.5" />
  </>,
);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const CloseIcon = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const TrashIcon = icon(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />);
export const CopyIcon = icon(
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
  </>,
);
export const UndoIcon = icon(<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />);
export const MoreIcon = icon(
  <>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </>,
);
export const SlidersIcon = icon(
  <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
);
export const PencilIcon = icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />);
export const EyeIcon = icon(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const EyeOffIcon = icon(
  <path d="M3 3l18 18M10.6 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
);
export const PhoneIcon = icon(
  <>
    <rect x="7" y="2" width="10" height="20" rx="2" />
    <path d="M11 18h2" />
  </>,
);
export const TabletIcon = icon(
  <>
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M11 18h2" />
  </>,
);
export const DesktopIcon = icon(
  <>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </>,
);
export const RefreshIcon = icon(<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5" />);
export const PlayIcon = icon(<path d="M7 4.5v15l12-7.5L7 4.5Z" fill="currentColor" />);
export const StopIcon = icon(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />);
export const ImageIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 16-5-5-9 9" />
  </>,
);
export const AppsIcon = icon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);

// Widget types
export const GamepadIcon = icon(
  <>
    <rect x="2" y="6" width="20" height="12" rx="6" />
    <path d="M6 12h4M8 10v4" />
    <circle cx="15.5" cy="11" r="1" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </>,
);
export const TerminalIcon = icon(
  <>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m6 9 3 3-3 3M12 15h5" />
  </>,
);
export const CameraIcon = icon(
  <>
    <path d="m22 8-6 4 6 4V8Z" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </>,
);
export const MapIcon = icon(<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14" />);
export const FlagIcon = icon(<path d="M5 21V4M5 4h12l-2.5 4.5L17 13H5" />);
export const LocateIcon = icon(
  <>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </>,
);
export const FitIcon = icon(
  <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
);
export const NavigationIcon = icon(<path d="m3 11 19-9-9 19-2-8-8-2Z" />);
export const PowerIcon = icon(<path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0" />);
export const ArmIcon = icon(
  <>
    <path d="M4 21h9M8 21v-4.5l5-6.5 5 2.5M18 12.5l2.5-3M18 12.5l2 3" />
    <circle cx="8" cy="16.5" r="1.6" />
    <circle cx="13" cy="10" r="1.6" />
  </>,
);
export const AngleIcon = icon(<path d="M4 20 18 6M4 20h16M11 20a7 7 0 0 0-2.1-5" />);
export const CubeIcon = icon(<path d="M12 2 3 7v10l9 5 9-5V7l-9-5ZM3 7l9 5 9-5M12 12v10" />);
export const QuestionIcon = icon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
  </>,
);
// A behavior tree, and its nodes: what they do by their shape, as their
// colour says how they are doing
export const TreeIcon = icon(
  <>
    <rect x="9" y="3" width="6" height="5" rx="1.2" />
    <rect x="3" y="16" width="6" height="5" rx="1.2" />
    <rect x="15" y="16" width="6" height="5" rx="1.2" />
    <path d="M12 8v4M6 16v-4h12v4" />
  </>,
);
export const ListIcon = icon(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />);
export const HistoryIcon = icon(<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2" />);
export const ArrowRightIcon = icon(<path d="M4 12h15M13 6l6 6-6 6" />);
export const QuestionMarkIcon = icon(<path d="M8.5 8.5a3.5 3.5 0 1 1 5 3.2c-.9.4-1.5 1.3-1.5 2.3v.5M12 19.5h.01" />);
export const ParallelIcon = icon(<path d="M4 8h13M4 16h13M14 4l4 4-4 4M14 12l4 4-4 4" />);
export const ForkIcon = icon(<path d="M12 3v7M12 10l-6 7v4M12 10l6 7v4" />);
export const DiamondIcon = icon(<path d="m12 3 9 9-9 9-9-9 9-9Z" />);
export const BoltIcon = icon(<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />);
export const CheckCircleIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.8 2.8L16 9.8" />
  </>,
);
export const RecordIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
  </>,
);
export const PauseIcon = icon(
  <>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </>,
);
export const FilmIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </>,
);
