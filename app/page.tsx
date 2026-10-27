import type { Metadata } from "next";
import { RadioExperience } from "./RadioExperience";

export const metadata: Metadata = {
  title: "CODIO - Private Radio",
  description: "一座逐渐懂你的私人音乐电台。",
};

export default function Home() {
  return <RadioExperience />;
}
