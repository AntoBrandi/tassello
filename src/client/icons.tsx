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
export const RedoIcon = icon(<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />);
export const SaveIcon = icon(
  <>
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V3Z" />
    <path d="M8 3v5h7V3M8 21v-7h8v7" />
  </>,
);
export const CodeIcon = icon(<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />);
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
// The tree, a pencil on its right branch: the behavior tree editor
export const TreeEditIcon = icon(
  <>
    <rect x="9" y="3" width="6" height="5" rx="1.2" />
    <rect x="3" y="16" width="6" height="5" rx="1.2" />
    <path d="M12 8v4M6 16v-4h7" />
    <path d="M19.2 11.8a1.6 1.6 0 0 1 2.3 2.3L15.8 19.8l-3 .7.7-3Z" />
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
// Lines of a log, the last ones of note: the logs widget
export const LogsIcon = icon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 8h10M7 12h6M7 16h8" />
    <circle cx="17.5" cy="16" r="1" fill="currentColor" stroke="none" />
  </>,
);
// Nodes of the ROS graph
export const NodesIcon = icon(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <circle cx="9" cy="18" r="2.5" />
    <path d="M8.4 6.7 15.6 8.4M16.5 11.1l-5.6 5.1M6.6 8.4l1.8 7.1" />
  </>,
);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.3-4.3" />
  </>,
);
export const BanIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </>,
);
export const FilterIcon = icon(<path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z" />);
export const DownloadIcon = icon(<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />);
// To the newest, at the bottom
export const ArrowDownToLineIcon = icon(<path d="M12 4v12M7 11l5 5 5-5M5 20h14" />);
// A pulse, in a frame: the diagnostics widget
export const DiagnosticsIcon = icon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M6.5 12.5h2.5l1.8-4.5 2.6 8 1.8-3.5h2.3" />
  </>,
);
// Chevrons apart: every group unfolded
export const UnfoldIcon = icon(<path d="m7 15 5 5 5-5M7 9l5-5 5 5" />);
// The file manager widget
export const FolderIcon = icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />);
export const FolderPlusIcon = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM12 10.5v5M9.5 13h5" />,
);
export const FileIcon = icon(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5" />);
export const FileTextIcon = icon(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h6" />);
export const FilePlusIcon = icon(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M12 11.5v6M9 14.5h6" />);
export const UploadIcon = icon(<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />);
export const ArrowUpIcon = icon(<path d="M12 20V5M6 11l6-6 6 6" />);
export const ArrowLeftIcon = icon(<path d="M20 12H5M11 6l-6 6 6 6" />);
export const HomeIcon = icon(<path d="m3 11 9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5" />);
export const HardDriveIcon = icon(
  <>
    <rect x="2.5" y="13" width="19" height="8" rx="2" />
    <path d="M5.5 13 8 4h8l2.5 9M6.5 17h.01M10 17h.01" />
  </>,
);
export const BookmarkIcon = icon(<path d="M6 3h12v18l-6-4.5L6 21V3Z" />);
export const SidebarIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
// What takes the space
export const PieChartIcon = icon(<path d="M21 12A9 9 0 1 1 12 3v9h9ZM15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" />);
export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5h.01" />
  </>,
);
// Long lines wrapped
export const WrapIcon = icon(<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4M3 18h7M16 16l-2 2 2 2" />);
export const LinkIcon = icon(
  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
);
export const LockIcon = icon(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);
export const ArchiveIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </>,
);
// A shell's prompt: the Terminal widget
export const ShellIcon = icon(<path d="m4 17 6-6-6-6M12 19h8" />);
export const KeyboardIcon = icon(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 12.5h.01M12 12.5h.01M16 12.5h.01M7 16h10" />
  </>,
);
export const MaximizeIcon = icon(
  <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
);
export const MinimizeIcon = icon(
  <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />,
);
export const ClipboardIcon = icon(
  <>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </>,
);
export const TextSmallerIcon = icon(<path d="m3 19 5-13 5 13M5 14h6M16 9h6" />);
export const TextLargerIcon = icon(<path d="m3 19 5-13 5 13M5 14h6M16 9h6M19 6v6" />);
// A router, broadcasting: the Networking widget
export const NetworkIcon = icon(
  <>
    <rect x="2.5" y="14" width="19" height="7" rx="2" />
    <path d="M6.5 17.5h.01M10 17.5h.01M16 14v-4" />
    <path d="M13.5 7.5a3.5 3.5 0 0 1 5 0M11.2 5.2a6.8 6.8 0 0 1 9.6 0" />
  </>,
);
export const WifiIcon = icon(
  <>
    <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 15.9a5 5 0 0 1 6.8 0" />
    <circle cx="12" cy="19.3" r="1.3" fill="currentColor" stroke="none" />
  </>,
);
export const WifiOffIcon = icon(
  <>
    <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 15.9a5 5 0 0 1 6.8 0M3 3l18 18" />
    <circle cx="12" cy="19.3" r="1.3" fill="currentColor" stroke="none" />
  </>,
);
// A port with its pins: a cable's connection
export const EthernetIcon = icon(
  <>
    <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3.5v3h-9v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    <path d="M7.5 9v2.5M10.5 9v2.5M13.5 9v2.5M16.5 9v2.5" />
  </>,
);
// Broadcasting: an access point, the robot's own network
export const HotspotIcon = icon(
  <>
    <circle cx="12" cy="12" r="2" />
    <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
  </>,
);
// A VPN
export const ShieldIcon = icon(<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />);
// The ROS monitor widget
export const MinusIcon = icon(<path d="M5 12h14" />);
// The graph's topics, services and actions: messages flowing one way; a
// request and its answer; a goal followed to its end
export const TopicIcon = icon(
  <>
    <circle cx="5" cy="12" r="2" />
    <path d="M7 12h12M15 8l4 4-4 4" />
  </>,
);
export const ServiceIcon = icon(<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />);
export const ActionIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </>,
);
// The graph watched: a screen with a pulse
export const MonitorIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M6.5 11h2.5l1.5-3 3 6 1.5-3h2.5M9 21h6M12 17v4" />
  </>,
);
// A processor: a chip and its pins
export const ChipIcon = icon(
  <>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5" />
  </>,
);
// Numbers over time: a plot's
export const PlotIcon = icon(<path d="M3 3v18h18M7 15l3.5-5 3 3L20 6" />);
export const CheckIcon = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />);
// Published, called, sent
export const SendIcon = icon(<path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" />);
// The world's meridians and parallels: a web page
export const GlobeIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>,
);
// A dial and its needle
export const SpeedometerIcon = icon(
  <>
    <path d="M4.2 18.5A9 9 0 1 1 19.8 18.5" />
    <path d="m12 14 3.5-4.5" />
    <circle cx="12" cy="14" r="1" />
  </>,
);
// Out of the page, into a tab of its own
export const ExternalLinkIcon = icon(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />);
