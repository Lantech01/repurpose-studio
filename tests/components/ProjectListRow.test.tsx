import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectListRow } from "@/app/repurpose-studio/_hub/ProjectListRow";
import type { ProjectMeta } from "@/app/repurpose-studio/_hub/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

const project: ProjectMeta = {
  id: "empty-project",
  name: "Empty project",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  durationSec: 0,
};

afterEach(cleanup);

describe("ProjectListRow", () => {
  it("uses the gradient without requesting a thumbnail for a zero-duration project", () => {
    const { container } = render(
      <ProjectListRow project={project} onDelete={vi.fn()} />
    );

    expect(container.querySelector("img")).toBeNull();
  });

  it("requests a thumbnail for a playable project", () => {
    const { container } = render(
      <ProjectListRow
        project={{ ...project, durationSec: 3 }}
        onDelete={vi.fn()}
      />
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("/api/repurpose/thumb?id=empty-project")
    );
  });
});
