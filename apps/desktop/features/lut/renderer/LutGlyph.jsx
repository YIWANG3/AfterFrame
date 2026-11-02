// The LUT tool's rail icon: the word in a rounded frame, a badge with the
// weight of the stroked icons around it. Photographers know "LUT"; no
// pictogram for a colour lookup reads as one (two overlapping circles read as
// "blend").
export default function LutGlyph() {
  return (
    <span className="flex h-[14px] items-center rounded-[3px] border-[1.4px] border-current px-[2.5px] text-[8px] font-bold leading-none tracking-[0.03em]">
      LUT
    </span>
  );
}
